function [slat,slon,arclen,az] = WSPR_Link_GC6MIZ_DSDS_SDR_Function(da,sa1,sa2,sa3,na,rev,s1lon, s1lat, s2lon, s2lat, s3lon, s3lat, e1lon, e1lat, e2lon, e2lat, e3lon, e3lat)

warning('off');

% link=strcat(s1lon,s1lat,s2lon,s2lat,s3lon,s3lat,e1lon,e1lat,e2lon,e2lat,e3lon,e3lat)

% Earth Reference Sphere
s = referenceSphere('Earth');
R = earthRadius('meter');
s.LengthUnit = 'meter';
s.Radius=R;

az=0;

if da == '1'
    LineColour = [0,0,1];
elseif sa1 == '1'
    LineColour = [1,0,0];
elseif sa2 == '1'
    LineColour = [1,0.65,0];
elseif sa3 == '1'
    LineColour = [1,1,0];
elseif na == '1'
    LineColour = [0,1,0];
elseif and(sa3=='0',na=='0')
    LineColour = [0.65,0.65,0.65];
else
    LineColour = [0,0,0];
end


% if or(sa=='1',na=='1')
slon = (double(int8(s1lon)-65)*20)-180.00000000+0.04166667;
slat = (double(int8(s1lat)-65)*10)-90.00000000+0.02083333;
slon = slon+(double(int8(s2lon)-48)*2);
slat = slat+(double(int8(s2lat)-48)*1);
slon = slon+(double(int8(s3lon)-97)*0.08333333);
slat = slat+(double(int8(s3lat)-97)*0.04166667);


elon = (double(int8(e1lon)-65)*20)-180.00000000+0.04166667;
elat = (double(int8(e1lat)-65)*10)-90.00000000+0.02083333;
elon = elon+(double(int8(e2lon)-48)*2);
elat = elat+(double(int8(e2lat)-48)*1);
elon = elon+(double(int8(e3lon)-97)*0.08333333);
elat = elat+(double(int8(e3lat)-97)*0.04166667);


%Great Circle Tracks
[arclen,az] = distance(slat,slon,elat,elon,s);
arclenlp=40030174-arclen;
azlp = azimuth(elat,elon,slat,slon,s)-180;
[lttrk,lntrk] = track1(slat,slon,az,arclen,s,'degrees',100);
if rev=="1"
    geoshow(lttrk,lntrk,'DisplayType','line','color',LineColour,'LineWidth',2,'LineStyle','--');
else
    geoshow(lttrk,lntrk,'DisplayType','line','color',LineColour,'LineWidth',2,'LineStyle','-');
end    
[lttrk,lntrk] = track1(elat,elon,azlp,arclenlp,s,'degrees',100);
if rev=="1"
    geoshow(lttrk,lntrk,'DisplayType','line','color',LineColour,'LineWidth',1,'LineStyle','--');
else
    geoshow(lttrk,lntrk,'DisplayType','line','color',LineColour,'LineWidth',1,'LineStyle','-');
end    
geoshow(slat,slon,'Marker','.','color','k','MarkerSize',16);
geoshow(elat,elon,'Marker','.','color','m','MarkerSize',16);



% end

